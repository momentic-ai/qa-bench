import { gradeFullAppEval } from "./tasks/full-app/grade";
import { runFullAppEval } from "./tasks/full-app/main";
import { parseFullAppOptions } from "./tasks/full-app/options";

const options = parseFullAppOptions(process.argv.slice(2));
if (options.gradeOnly) {
  await gradeFullAppEval(options);
} else {
  await runFullAppEval(options);
}
