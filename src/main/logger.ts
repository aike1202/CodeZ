import log from 'electron-log/main';
import { app, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc/channels';

// 初始化日志配置
export function setupLogger() {
  log.initialize();

  // 配置日志格式
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{processType}] [{level}] {text}';
  log.transports.console.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{processType}] [{level}] {text}';

  // 配置日志大小 (10MB)
  log.transports.file.maxSize = 10 * 1024 * 1024;

  // 可选：覆盖原生的 console.log/error，这样不改代码也能抓到报错
  // 如果不需要，可以注释掉这两行
  Object.assign(console, log.functions);

  // 捕获未处理的异常
  log.errorHandler.startCatching();

  // 监听渲染进程的日志
  ipcMain.on(IPC_CHANNELS.APP_LOG, (event, level, ...args) => {
    const fn = log[level as keyof typeof log] as any;
    if (typeof fn === 'function') {
      fn('[renderer]', ...args);
    } else {
      log.info('[renderer]', level, ...args);
    }
  });

  log.info('=============================================');
  log.info(`App Starting: ${app.getName()} v${app.getVersion()}`);
  log.info(`Log File Location: ${log.transports.file.getFile().path}`);
  log.info('=============================================');
}

export default log;
