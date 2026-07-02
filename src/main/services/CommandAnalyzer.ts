export type CommandRisk = 'safe' | 'write' | 'network' | 'destructive' | 'unknown'

export class CommandAnalyzer {
  private static readonly SHELL_INJECTION_PATTERN = /[&|;<>$`]/
  
  // Level 0: Safe / Read-Only
  private static readonly SAFE_PREFIXES = [
    'git status', 'git log', 'git diff', 'git branch', 'git show', 'git remote -v',
    'mvn -v', 'mvn dependency:tree', 
    'gradle -v', 'gradle dependencies', 'gradle tasks',
    'java -version', 'javac -version',
    'npm config get', 'node -v', 
    'pip freeze', 'pip show',
    'ls', 'pwd', 'echo', 'cat', 'Get-ChildItem', 'Get-Location'
  ]

  // Level 1: Workspace Write
  private static readonly WRITE_PREFIXES = [
    'npm run build', 'npm run test', 'yarn build', 'pnpm build', 'pnpm test',
    'mvn compile', 'mvn test', 'mvn package',
    'gradle build', 'gradle test', 'gradle assemble',
    'python test.py', 'pytest',
    'git add', 'git commit', 'git checkout', 'git merge', 'git rebase', 'git stash',
    'mkdir', 'touch', 'cp', 'mv', 'New-Item', 'Copy-Item'
  ]

  // Level 2: Network / External
  private static readonly NETWORK_PREFIXES = [
    'npm install', 'npm i', 'npm add', 'yarn add', 'pnpm install', 'pnpm add',
    'pip install', 'mvn install', 'gradle sync',
    'git push', 'git fetch', 'git pull', 'git clone',
    'curl', 'wget', 'Invoke-WebRequest'
  ]

  // Level 3: Destructive
  private static readonly DESTRUCTIVE_PREFIXES = [
    'rm', 'rmdir', 'rd', 'Remove-Item', 'del',
    'git reset --hard', 'git clean', 'git push --force',
    'mvn clean', 'gradle clean',
    'sudo', 'chmod', 'chown', 'kill', 'Stop-Process',
    'format', 'mkfs', 'dd'
  ]

  public static analyze(command: string): CommandRisk {
    const cmd = command.trim()
    const lowerCmd = cmd.toLowerCase()

    // 1. Guard against Shell Injection (Level 3)
    if (this.SHELL_INJECTION_PATTERN.test(cmd)) {
      return 'destructive'
    }

    // 2. Destructive Commands (Level 3)
    if (this.DESTRUCTIVE_PREFIXES.some(p => lowerCmd === p.toLowerCase() || lowerCmd.startsWith(`${p.toLowerCase()} `))) {
      return 'destructive'
    }

    // 3. Safe Commands (Level 0)
    // Extra safety: make sure they don't contain destructive flags like -delete or --exec
    if (this.SAFE_PREFIXES.some(p => lowerCmd === p.toLowerCase() || lowerCmd.startsWith(`${p.toLowerCase()} `))) {
      if (lowerCmd.includes('-delete') || lowerCmd.includes('--exec')) {
        return 'destructive'
      }
      return 'safe'
    }

    // 4. Network Commands (Level 2)
    if (this.NETWORK_PREFIXES.some(p => lowerCmd === p.toLowerCase() || lowerCmd.startsWith(`${p.toLowerCase()} `))) {
      return 'network'
    }

    // 5. Write Commands (Level 1)
    if (this.WRITE_PREFIXES.some(p => lowerCmd === p.toLowerCase() || lowerCmd.startsWith(`${p.toLowerCase()} `))) {
      return 'write'
    }

    return 'unknown'
  }
}
