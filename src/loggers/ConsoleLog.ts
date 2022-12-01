import { Logger } from "../interfaces/logger";

export default class ConsoleLog implements Logger {
  log(stg: any) {
    console.log(stg);
  }

  table(stg: any) {
    console.table(stg);
  }

  error(stg: any) {
    console.error(stg);
  }

  flush() {}
}
