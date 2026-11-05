// Parse one file and write its AST, in a process of its own. astgen starts this with a larger
// heap (`--max-old-space-size`) for a file whose AST does not fit in the heap astgen has left,
// so that running out of memory ends this process and not astgen. The argument is a JSON object
// with the file, the project type and the input and output directories.
import { exitWithSupervisor } from "../supervise.js";
import { fileToJsAst, writeAstFile } from "../astgen.js";

// astgen passes its own pid as ATOM_PARENT_PID, so this process stops when astgen is gone
exitWithSupervisor();

const { file, type, src, output } = JSON.parse(process.argv[2]);
writeAstFile(file, fileToJsAst(file, type), { src, output });
