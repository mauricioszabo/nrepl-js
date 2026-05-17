function helper() { return 1; }
exports.doWork = function () { return helper() + 100; };
exports.tick = function () { console.log('tick=', exports.doWork()); };
