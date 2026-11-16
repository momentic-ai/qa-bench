import { gradeFullAppEval } from "./grade";
import { parseFullAppOptions } from "./options";
import { runFullAppEval } from "./run";

const options = parseFullAppOptions(process.argv.slice(2));
if (options.gradeOnly) {
  await gradeFullAppEval(options);
} else {
  await runFullAppEval(options);
}
