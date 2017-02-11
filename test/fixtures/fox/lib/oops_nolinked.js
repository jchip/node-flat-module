//
// requiring within a linked module itself will lose the
// original parent in CWD.
//
// In this case, parent is also within linked module, and
// not under CWD.
//
// The only way is from the __linked_from.json file.
//
module.exports = require("../oops_nolinked_2");
