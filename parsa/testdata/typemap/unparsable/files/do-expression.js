// A do expression: Babel parses it with the doExpressions plugin; the pinned tsgo recovers.
let value = do {
  if (Math.random() > 0.5) {
    "big";
  } else {
    "small";
  }
};

export const nested = do {
  const inner = 41;
  inner + 1;
};
