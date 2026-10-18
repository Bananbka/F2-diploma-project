import logging
import sys
from loguru import logger


class InterceptHandler(logging.Handler):
    def emit(self, record):
        try:
            level = logger.level(record.levelname).name
        except ValueError:
            level = record.levelno

        frame, depth = logging.currentframe(), 2
        while frame.f_code.co_filename == logging.__file__:
            frame = frame.f_back
            depth += 1

        logger.opt(depth=depth, exception=record.exc_info).log(level, record.getMessage())


def setup_logging(is_production: bool = False):
    logger.remove()

    if is_production:
        logger.add(
            sys.stdout,
            format="{message}",
            serialize=True,
            level="INFO"
        )
    else:
        logger.add(
            sys.stdout,
            colorize=True,
            format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>",
            level="DEBUG"
        )

    # Deliberately does NOT touch "uvicorn.access". `app.main`'s own `log_requests` middleware
    # already logs every request/response through loguru and redacts the invite-link token from
    # the path before doing so (see `_loggable_path` there); uvicorn is started with
    # `--no-access-log`, which works by clearing "uvicorn.access"'s handlers so
    # `logger.hasHandlers()` is False and the per-request access-log call never fires
    # (`h11_impl.py`). Attaching a handler here — even one that routes through loguru — would
    # make `hasHandlers()` true again and silently re-enable that *unredacted* access log
    # alongside ours, which is exactly the leak this was meant to close.
    logging.getLogger("uvicorn.error").handlers = [InterceptHandler()]
    logging.getLogger("fastapi").handlers = [InterceptHandler()]
