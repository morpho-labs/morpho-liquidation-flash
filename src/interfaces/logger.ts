export interface Logger {
  log: (toLog: any) => any;
  table: (toLog: any) => any;
  flush: () => any | Promise<any>;
}
