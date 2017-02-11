"use strict";

require("../lib");
delete require.cache[require.resolve("zoo")];
const zoo = require("zoo");
require("zoo/lib2/resolve_from_linked");
const foo = require("zoo/lib/resolve_from_linked");
module.exports = {
  zoo,
  foo
};
