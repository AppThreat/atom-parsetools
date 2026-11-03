TypeScript 6 type maps for ../src, written by astgen 1.10.6 (`node astgen.js -i native/testdata/typemap/rules -o <dir>`,
then the `.typemap` files). They are the baseline for test-fixtures/typemap-diff-regression.js and are not compared
byte for byte with `../expected`: union order and a few reviewed classes differ (see test-fixtures/typemap-allow.json).
