import { Logger } from "../interfaces/logger";

export default class NoLogger implements Logger {
  log() {}
  table() {}
  error() {}
  flush() {}
}
