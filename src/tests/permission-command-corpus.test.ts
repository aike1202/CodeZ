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

  it.each([
    ['npm --version', 'shell', 0],
    ['npm version', 'external_effect', 1],
    ['npm publish', 'network', 2],
    ['npm config get registry', 'shell', 1],
    ['npm config set registry https://registry.example.test', 'external_effect', 2],
    ['pnpm config delete registry', 'external_effect', 2],
    ['yarn config unset registry', 'external_effect', 2],
    ['npm --prefix packages/app install', 'network', 2],
    ['pnpm -C packages/app add react', 'network', 2],
    ['npm install react --version', 'network', 2],
    ['cargo install ripgrep --version 14.1.0', 'network', 2],
    ['docker run node:22 --version', 'external_effect', 2],
    ['iwr https://example.test', 'network', 2],
    ['irm https://example.test/api', 'network', 2],
    ['git reset --hard', 'delete', 3],
    ['git push --force origin main', 'hardline', 4],
    ['git push -fu origin main', 'hardline', 4],
    ['git push origin +main', 'hardline', 4],
    ['git push --mirror origin', 'hardline', 4]
  ] as const)('classifies %s with the expected capability and metadata', (command, permission, riskLevel) => {
    expect(classifyKnownCommand(command.split(/\s+/))).toMatchObject({ permission, riskLevel })
  })
})
