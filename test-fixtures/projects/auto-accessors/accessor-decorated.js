// Decorated TC39 auto-accessors in plain JavaScript (atom-parsetools#34).
// `accessor mouse` is a ClassAccessorProperty; the initialiser calls a helper,
// and the decorator is an ordinary Decorator node on the member.
function track(target, key) {
  return target[key];
}

function nanoid() {
  return "n4n0";
}

function idFactory() {
  return () => 0;
}

class Point {
  @track accessor mouse = nanoid();
  @track static accessor count = idFactory();
  accessor untouched = 41;
}

export { Point };
