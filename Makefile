BIN     := jsonviewer
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)
GOFLAGS := -trimpath

.PHONY: build run clean release linux-amd64 linux-arm64 test

build:
	CGO_ENABLED=0 go build $(GOFLAGS) -ldflags "$(LDFLAGS)" -o $(BIN) .

run: build
	./$(BIN) -listen 127.0.0.1:8080 -access-log

test:
	go vet ./... && go test ./...

# 交叉编译，产物放在 dist/
linux-amd64:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build $(GOFLAGS) -ldflags "$(LDFLAGS)" -o dist/$(BIN)-linux-amd64 .
linux-arm64:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build $(GOFLAGS) -ldflags "$(LDFLAGS)" -o dist/$(BIN)-linux-arm64 .
release: linux-amd64 linux-arm64

clean:
	rm -rf $(BIN) dist
