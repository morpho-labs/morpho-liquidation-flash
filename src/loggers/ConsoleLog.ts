import { Logger } from "../interfaces/logger";

export default class ConsoleLog implements Logger {
  log(sth: any) {
    console.log(sth);
  }

  flush() {}
}
