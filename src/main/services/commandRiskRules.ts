export const SAFE_PREFIXES = [
  'git status', 'git log', 'git diff', 'git branch --show-current', 'git branch -a',
  'git branch --all', 'git show', 'git remote -v', 'git remote get-url', 'git rev-parse',
  'git ls-files', 'git blame',
  'mvn -v', 'mvn dependency:tree',
  'gradle -v', 'gradle dependencies', 'gradle tasks',
  'java -version', 'javac -version',
  'npm config get', 'npm view', 'node -v',
  'pip freeze', 'pip show',
  'ls', 'pwd', 'echo', 'cat', 'Get-ChildItem', 'Get-Location', 'Get-Content', 'Get-Item',
  'Get-Process', 'Get-Service', 'Resolve-Path', 'Join-Path', 'Split-Path', 'Get-Date',
  'Select-String', 'Select-Object', 'Format-Table', 'Format-List', 'Measure-Object', 'Sort-Object',
  'Test-Path', 'Get-Command', 'where',
  'tree', 'find', 'less', 'head', 'tail', 'grep', 'rg', 'awk', 'sed', 'which', 'uname',
  'whoami', 'hostname', 'date',
  'python --version', 'python -V'
]

export const WRITE_PREFIXES = [
  'npm run build', 'npm run test', 'npm run dev', 'npm start', 'npm run lint', 'npm run format', 'npm run typecheck',
  'yarn build', 'yarn dev', 'yarn lint', 'yarn typecheck',
  'pnpm build', 'pnpm test', 'pnpm dev', 'pnpm lint', 'pnpm typecheck',
  'mvn compile', 'mvn test', 'mvn package',
  'gradle build', 'gradle test', 'gradle assemble',
  'python', 'pytest', 'node', 'make',
  'git add', 'git commit', 'git checkout', 'git branch', 'git merge', 'git rebase', 'git stash',
  'mkdir', 'touch', 'cp', 'mv', 'New-Item', 'Copy-Item', 'Move-Item',
  'Set-Content', 'Add-Content', 'Out-File'
]

export const NETWORK_PREFIXES = [
  'npm install', 'npm i', 'npm add', 'npm ci', 'yarn install', 'yarn add', 'pnpm install', 'pnpm add',
  'pip install', 'python -m pip install', 'mvn install', 'gradle sync',
  'apt-get', 'apt', 'brew',
  'git push', 'git fetch', 'git pull', 'git clone',
  'curl', 'wget', 'Invoke-WebRequest', 'Invoke-RestMethod',
  'gh pr create', 'gh pr checkout', 'gh repo clone',
  'docker pull', 'docker build', 'docker compose pull'
]

export const DESTRUCTIVE_PREFIXES = [
  'rm', 'rmdir', 'rd', 'Remove-Item', 'del',
  'git reset --hard', 'git clean', 'git push --force', 'git push --force-with-lease',
  'mvn clean', 'gradle clean',
  'sudo', 'su', 'chmod', 'chown', 'kill', 'pkill', 'Stop-Process', 'taskkill',
  'reboot', 'shutdown', 'systemctl', 'iptables',
  'format', 'mkfs', 'dd',
  'docker rm', 'docker rmi', 'docker system prune',
  'kubectl delete'
]
