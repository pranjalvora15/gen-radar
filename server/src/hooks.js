export function registerHooks(fastify, { closeDatabase }) {
  fastify.addHook("onResponse", async (request, reply) => {
    request.log.info({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      elapsedMs: Math.round(reply.elapsedTime)
    }, "request completed");
  });

  fastify.addHook("onClose", async () => {
    if (closeDatabase) {
      await fastify.db.end();
    }
  });

  fastify.setErrorHandler((error, request, reply) => {
    request.log.error(error);

    if (error.validation) {
      return reply.code(400).send({ message: "Invalid request" });
    }

    const hasKnownStatus =
      Number.isInteger(error.statusCode)
      && error.statusCode >= 400
      && error.statusCode < 600;
    const statusCode = hasKnownStatus ? error.statusCode : 500;

    return reply
      .code(statusCode)
      .send({ message: hasKnownStatus ? error.message : "Internal server error" });
  });
}
