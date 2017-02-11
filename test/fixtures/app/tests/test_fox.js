"use strict";

// test linked module missing __linked_from.json file

const fox = require("fox");
require("fox/lib/oops_nolinked");
module.exports = {
  fox
};
