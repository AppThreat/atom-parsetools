// Legacy decorators, the syntax astgen has always parsed with the
// `decorators-legacy` plugin: decorator before the member, decorator before
// `static`, decorator first on a class declaration or expression. The
// auto-accessor plugin must not change a byte of this file's AST.
function seal(target) {
  return target;
}

function readonly(target, key) {
  return target[key];
}

@seal
export class Login {
  @readonly attempts = 0;
  @readonly secret = "s";

  @readonly submit(user) {
    return user;
  }
}

const fallback = @seal class {};

export default fallback;
