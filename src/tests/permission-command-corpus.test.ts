import { describe, expect, it } from 'vitest'
import { classifyKnownCommand } from '../main/services/permission/commandPolicies'

const commands = [
  'git status', 'git diff', 'git log -5', 'git show HEAD', 'git commit -m test', 'git fetch', 'git push', 'git reset --hard',
  'npm test', 'npm run build', 'npm run typecheck', 'npm install react', 'pnpm test', 'pnpm add react', 'yarn build', 'bun test',
  'python --version', 'python app.py', 'python -m pip install requests', 'pytest', 'pip install requests', 'uv sync',
  'cargo check', 'cargo test', 'cargo build', 'cargo install ripgrep', 'rustc --version',
  'go test ./...', 'go build ./...', 'go get example.com/mod', 'go version',
  'mvn test', 'mvn package', 'gradle test', 'gradlew build', 'java -version',
  'dotnet test', 'dotnet build', 'dotnet add package xunit',
  'cmake --build build', 'make test', 'ninja -C build',
  'docker ps', 'docker compose up', 'kubectl get pods', 'helm list',
  'ls -la', 'pwd', 'rg TODO src', 'cat package.json', 'Get-Content README.md', 'Test-Path package.json', 'dir', 'where git'
]

describe('permission common command corpus', () => {
  it('classifies at least 95 percent without unknown fallback', () => {
    const classified = commands.filter((command) => classifyKnownCommand(command.split(/\s+/))).length
    expect(classified / commands.length).toBeGreaterThanOrEqual(0.95)
  })
})
