package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	pbkdf2Iterations = 210000
	pbkdf2SaltLen    = 16
	pbkdf2KeyLen     = 32
	maxPasswordLen   = 1024
	minPasswordLen   = 6
	usersFileVersion = 1
)

// pbkdf2SHA256 实现 RFC 8018 的 PBKDF2，PRF 为 HMAC-SHA256。
func pbkdf2SHA256(password, salt []byte, iter, keyLen int) []byte {
	prf := hmac.New(sha256.New, password)
	hLen := prf.Size()
	blocks := (keyLen + hLen - 1) / hLen
	out := make([]byte, 0, blocks*hLen)
	var idx [4]byte
	u := make([]byte, hLen)
	t := make([]byte, hLen)
	for i := 1; i <= blocks; i++ {
		prf.Reset()
		prf.Write(salt)
		binary.BigEndian.PutUint32(idx[:], uint32(i))
		prf.Write(idx[:])
		u = prf.Sum(u[:0])
		copy(t, u)
		for n := 1; n < iter; n++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(u[:0])
			for k := range t {
				t[k] ^= u[k]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}

// hashPassword 返回 pbkdf2-sha256$<iter>$<salt_b64>$<hash_b64>。
func hashPassword(pw string) string {
	if len(pw) > maxPasswordLen {
		pw = pw[:maxPasswordLen]
	}
	salt := make([]byte, pbkdf2SaltLen)
	if _, err := rand.Read(salt); err != nil {
		panic("crypto/rand: " + err.Error())
	}
	key := pbkdf2SHA256([]byte(pw), salt, pbkdf2Iterations, pbkdf2KeyLen)
	enc := base64.RawStdEncoding
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", pbkdf2Iterations, enc.EncodeToString(salt), enc.EncodeToString(key))
}

// verifyPassword 按哈希中记录的迭代次数重新计算并常量时间比较。
func verifyPassword(hash, pw string) bool {
	if len(pw) > maxPasswordLen {
		return false
	}
	parts := strings.Split(hash, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter < 1 || iter > 10_000_000 {
		return false
	}
	enc := base64.RawStdEncoding
	salt, err := enc.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := enc.DecodeString(parts[3])
	if err != nil || len(want) == 0 || len(want) > 64 {
		return false
	}
	got := pbkdf2SHA256([]byte(pw), salt, iter, len(want))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// validUsername：1–32 个字符，仅 [A-Za-z0-9_.-]，区分大小写。
func validUsername(name string) bool {
	if len(name) < 1 || len(name) > 32 {
		return false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '.', c == '-':
		default:
			return false
		}
	}
	return true
}

// User 是 users.json 中的一条用户记录。
type User struct {
	Name         string    `json:"name"`
	PasswordHash string    `json:"password_hash"`
	Admin        bool      `json:"admin"`
	CreatedAt    time.Time `json:"created_at"`
}

type usersFile struct {
	Version int    `json:"version"`
	Users   []User `json:"users"`
}

var (
	errUserExists      = errors.New("用户名已存在")
	errUserNotFound    = errors.New("用户不存在")
	errInvalidName     = errors.New("用户名不合法（1–32 个字符，仅限字母、数字、_ . -）")
	errLastAdmin       = errors.New("不能删除或降级最后一个管理员")
	errAlreadySetup    = errors.New("已完成初始设置")
	errPasswordTooLong = fmt.Errorf("密码不能超过 %d 字节", maxPasswordLen)
)

// userStore 保存全部用户，并持久化到 JSON 文件。
type userStore struct {
	path  string
	mu    sync.RWMutex
	users []User
	fi    os.FileInfo // 上次加载或保存后文件的状态，用于发现外部修改
}

// loadUsers 读取用户文件；文件不存在时返回空列表。
func loadUsers(path string) (*userStore, error) {
	s := &userStore{path: path}
	users, fi, err := readUsersFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return s, nil
		}
		return nil, err
	}
	s.users, s.fi = users, fi
	return s, nil
}

// readUsersFile 读取并解析用户文件，同时返回读取前的文件状态。
func readUsersFile(path string) ([]User, os.FileInfo, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	var f usersFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, nil, fmt.Errorf("解析用户文件 %s 失败: %w", path, err)
	}
	if f.Version != usersFileVersion {
		return nil, nil, fmt.Errorf("用户文件 %s 版本不受支持: %d", path, f.Version)
	}
	return f.Users, fi, nil
}

// fileChanged 判断文件是否不同于上次记录的状态。两个写入方都用临时文件 + Rename，
// 因此 inode 变化（SameFile 为 false）是最可靠的信号；mtime 与大小作为补充。
func fileChanged(old, cur os.FileInfo) bool {
	if old == nil {
		return true
	}
	return !os.SameFile(old, cur) || !old.ModTime().Equal(cur.ModTime()) || old.Size() != cur.Size()
}

// reloadIfChanged 在文件被外部修改（如运行中执行 --reset-password）后重新读入。
// 文件不存在或解析失败时保留内存中的数据（避免误把系统当成未初始化而重新开放 /setup）。
func (s *userStore) reloadIfChanged() {
	cur, err := os.Stat(s.path)
	if err != nil {
		return
	}
	s.mu.RLock()
	changed := fileChanged(s.fi, cur)
	s.mu.RUnlock()
	if !changed {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if cur, err = os.Stat(s.path); err != nil || !fileChanged(s.fi, cur) {
		return
	}
	users, fi, err := readUsersFile(s.path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("重新读取用户文件失败，继续使用内存中的数据: %v", err)
		}
		return
	}
	s.users, s.fi = users, fi
	log.Printf("用户文件 %s 已在外部修改，已重新加载（%d 个用户）", s.path, len(users))
}

// save 原子地写回用户文件（临时文件 + Rename，权限 0600）。
func (s *userStore) save() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked()
}

func (s *userStore) saveLocked() error {
	users := s.users
	if users == nil {
		users = []User{}
	}
	data, err := json.MarshalIndent(usersFile{Version: usersFileVersion, Users: users}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	tmp, err := os.CreateTemp(filepath.Dir(s.path), "users.json.*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			tmp.Close()
			os.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return err
	}
	preserveOwner(tmpName, s.path)
	if err := os.Rename(tmpName, s.path); err != nil {
		return err
	}
	ok = true
	if fi, err := os.Stat(s.path); err == nil {
		s.fi = fi // 记录自己写入后的状态，避免下次误判为外部修改
	}
	return nil
}

func (s *userStore) indexLocked(name string) int {
	for i := range s.users {
		if s.users[i].Name == name {
			return i
		}
	}
	return -1
}

func (s *userStore) adminCountLocked() int {
	n := 0
	for i := range s.users {
		if s.users[i].Admin {
			n++
		}
	}
	return n
}

// find 返回用户副本。
func (s *userStore) find(name string) (User, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if i := s.indexLocked(name); i >= 0 {
		return s.users[i], true
	}
	return User{}, false
}

// add 新增用户（仅内存，需另行 save）。哈希在锁外计算。
func (s *userStore) add(name, pw string, admin bool) error {
	if !validUsername(name) {
		return errInvalidName
	}
	if len(pw) > maxPasswordLen {
		return errPasswordTooLong
	}
	if _, exists := s.find(name); exists {
		return errUserExists
	}
	u := User{Name: name, PasswordHash: hashPassword(pw), Admin: admin, CreatedAt: time.Now().UTC()}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.indexLocked(name) >= 0 {
		return errUserExists
	}
	s.users = append(s.users, u)
	return nil
}

// setupAdmin 在写锁内确认尚无用户后创建首个管理员并立即保存。
func (s *userStore) setupAdmin(name, pw string) error {
	if !validUsername(name) {
		return errInvalidName
	}
	if len(pw) > maxPasswordLen {
		return errPasswordTooLong
	}
	if s.count() != 0 {
		return errAlreadySetup
	}
	u := User{Name: name, PasswordHash: hashPassword(pw), Admin: true, CreatedAt: time.Now().UTC()}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.users) != 0 {
		return errAlreadySetup
	}
	s.users = append(s.users, u)
	if err := s.saveLocked(); err != nil {
		s.users = nil
		return err
	}
	return nil
}

// remove 删除用户；不允许删除最后一个管理员。
func (s *userStore) remove(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.indexLocked(name)
	if i < 0 {
		return errUserNotFound
	}
	if s.users[i].Admin && s.adminCountLocked() <= 1 {
		return errLastAdmin
	}
	s.users = append(s.users[:i], s.users[i+1:]...)
	return nil
}

// setPassword 修改密码（仅内存，需另行 save）。
func (s *userStore) setPassword(name, pw string) error {
	if len(pw) > maxPasswordLen {
		return errPasswordTooLong
	}
	if _, ok := s.find(name); !ok {
		return errUserNotFound
	}
	h := hashPassword(pw)
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.indexLocked(name)
	if i < 0 {
		return errUserNotFound
	}
	s.users[i].PasswordHash = h
	return nil
}

// setAdmin 设置或取消管理员；不允许取消最后一个管理员。
func (s *userStore) setAdmin(name string, admin bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.indexLocked(name)
	if i < 0 {
		return errUserNotFound
	}
	if !admin && s.users[i].Admin && s.adminCountLocked() <= 1 {
		return errLastAdmin
	}
	s.users[i].Admin = admin
	return nil
}

func (s *userStore) count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.users)
}

func (s *userStore) adminCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.adminCountLocked()
}

// list 返回按创建时间排序的副本。
func (s *userStore) list() []User {
	s.mu.RLock()
	out := make([]User, len(s.users))
	copy(out, s.users)
	s.mu.RUnlock()
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}
