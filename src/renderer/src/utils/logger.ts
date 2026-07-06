// 渲染进程的日志工具类，封装 window.api.logger

class Logger {
  info(...args: any[]) {
    window.api?.logger?.info(...args);
    console.info(...args);
  }

  warn(...args: any[]) {
    window.api?.logger?.warn(...args);
    console.warn(...args);
  }

  error(...args: any[]) {
    window.api?.logger?.error(...args);
    console.error(...args);
  }

  debug(...args: any[]) {
    window.api?.logger?.debug(...args);
    console.debug(...args);
  }
}

export const logger = new Logger();
export default logger;
