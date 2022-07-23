import { handler } from "../src/handlers/botHandler";
import * as dotenv from "dotenv";

dotenv.config();
handler()
  .then(console.log)
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
