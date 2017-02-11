"use strict";

// test linked module missing __linked_from.json file

const foo = require("foo");
const qqq1 = require("../../no-flat/index.js");
const qqq2 = require("../../no-flat/index2.js");
module.exports = {
  foo, qqq1, qqq2
};

