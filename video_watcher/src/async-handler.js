'use strict';

/**
 * Express 4 不会捕获 async 处理器抛出的异常。
 *
 * 后果非常严重：未处理的 Promise rejection 在 Node 15+ 下**默认终止进程**。
 * 对家庭媒体服务器来说，这意味着管理接口里任何一个意外异常，
 * 都会在你们正看片的时候把整个服务打死。
 *
 * 所以所有 async 路由都要用这个包一层，让异常走 Express 的错误中间件。
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
