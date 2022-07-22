export interface Logger {
  log: (toLog: any) => any;
  flush: () => any | Promise<any>;
}
