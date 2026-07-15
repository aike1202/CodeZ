import { describe, expect, it } from 'vitest'
import { classifyKnownCommand } from '../main/services/permission/commandPolicies'
import permissionGolden from './fixtures/migration/permission-runtime-golden.json'

const commands = [
  'git status', 'git diff', 'git log -5', 'git show HEAD', 'git commit -m test', 'git fetch', 'git push', 'git reset --hard',
  'npm test', 'npm run build', 'npm run typecheck', 'npm install react', 'pnpm test', 'pnpm add react', 'yarn build', 'bun test',
  'python --version', 'python app.py', 'python -m pip install requests', 'pytest', 'pip install requests', 'uv sync',
  'cargo check', 'cargo test', 'cargo build', 'cargo install ripgrep', 'rustc --version',
  'go test ./...', 'go build ./...', 'go get example.com/mod', 'go version',
  'mvn test', 'mvn package', './mvnw verify', '.\\mvnw.cmd test', 'gradle test', 'gradlew build', './gradlew test', '.\\gradlew.bat build', 'java -version',
  'dotnet test', 'dotnet build', 'dotnet add package xunit',
  'cmake --build build', 'make test', 'ninja -C build', 'msbuild app.sln', 'bazel test //...', 'meson compile -C build',
  'composer validate', 'bundle exec rspec', 'swift test', 'terraform plan',
  'docker ps', 'docker compose up', 'kubectl get pods', 'helm list',
  'ls -la', 'pwd', 'rg TODO src', 'cat package.json', 'Get-Content README.md', 'Test-Path package.json', 'dir', 'where git'
]

describe('permission common command corpus', () => {
  it.each(permissionGolden.dangerousCommands)(
    'keeps the migration golden decision for $command',
    ({ command, permission, riskLevel }) => {
      expect(classifyKnownCommand(command.split(/\s+/))).toMatchObject({ permission, riskLevel })
    }
  )

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
    ['npx vite build', 'network', 2],
    ['corepack prepare pnpm@latest --activate', 'external_effect', 2],
    ['corepack pnpm install', 'network', 2],
    ['conda install numpy', 'network', 2],
    ['poetry publish', 'external_effect', 2],
    ['pipx install ruff', 'network', 2],
    ['cargo install ripgrep --version 14.1.0', 'network', 2],
    ['cargo fetch', 'network', 2],
    ['cargo publish', 'external_effect', 2],
    ['docker run node:22 --version', 'external_effect', 2],
    ['npm.cmd install react', 'network', 2],
    ['.\\mvnw.cmd dependency:go-offline', 'network', 2],
    ['mvn dependency:resolve', 'network', 2],
    ['mvn org.apache.maven.plugins:maven-dependency-plugin:3.6.1:get', 'network', 2],
    ['mvn -U test', 'network', 2],
    ['mvn deploy', 'external_effect', 2],
    ['mvn deploy:deploy-file -Dfile=app.jar', 'external_effect', 2],
    ['mvn org.apache.maven.plugins:maven-deploy-plugin:3.1.4:deploy-file -Dfile=app.jar', 'external_effect', 2],
    ['./mvnw verify -DskipTests=false', 'shell', 1],
    ['.\\gradlew.bat test --refresh-dependencies', 'network', 2],
    ['gradle publish', 'external_effect', 2],
    ['gradle publishMavenJavaPublicationToMavenRepository', 'external_effect', 2],
    ['gradle :library:publishAllPublicationsToReleaseRepository', 'external_effect', 2],
    ['gradle publishToMavenLocal', 'shell', 1],
    ['sbt update', 'network', 2],
    ['sbt publishSigned', 'external_effect', 2],
    ['./gradlew clean test --no-daemon', 'shell', 1],
    ['composer install', 'network', 2],
    ['bundle install', 'network', 2],
    ['gem push app.gem', 'external_effect', 2],
    ['conan install .', 'network', 2],
    ['flutter pub get', 'network', 2],
    ['dart pub publish', 'external_effect', 2],
    ['mix deps.get', 'network', 2],
    ['nuget.exe restore app.sln', 'network', 2],
    ['nuget.exe push app.nupkg', 'external_effect', 2],
    ['dotnet restore', 'network', 2],
    ['dotnet tool install dotnet-ef', 'network', 2],
    ['dotnet nuget push app.nupkg', 'external_effect', 2],
    ['rustup toolchain install stable', 'network', 2],
    ['msbuild.exe app.sln /t:Build', 'shell', 1],
    ['terraform plan', 'external_effect', 2],
    ['gh pr create', 'external_effect', 2],
    ['adb install app.apk', 'external_effect', 2],
    ['mysql -e SELECT_1', 'external_effect', 2],
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
