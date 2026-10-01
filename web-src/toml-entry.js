// smol-toml 懒加载包：首次识别到 TOML（或选 TOML 为目标）时由 formats.js 动态插入 <script> 加载
import { parse, stringify, TomlDate, TomlError } from 'smol-toml';
window.JVToml = { parse, stringify, TomlDate, TomlError };
