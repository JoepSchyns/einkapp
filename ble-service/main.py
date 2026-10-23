import asyncio
import logging
import os
import pickle
from io import BytesIO
from pathlib import Path

from bleak import BleakScanner
from bleak.backends.device import BLEDevice
from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request
from opendisplay import FitMode, OpenDisplayDevice, discover_devices
from PIL import Image

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="BLE Info Display Service")

PUSH_DEADLINE_S = 900  # keep trying for 15 minutes (several wake cycles)
SCAN_WINDOW_S = 8      # restart the scan this often to reset the controller's duplicate filter
CONFIG_CACHE_DIR = Path("./device_cache")

_push_locks: dict[str, asyncio.Lock] = {}


def _norm_mac(mac: str) -> str:
    return mac.upper().replace("-", ":")


# --- Device config cache: lets later connects skip interrogation -------------

def _cache_file(mac: str) -> Path:
    return CONFIG_CACHE_DIR / f"{mac.replace(':', '')}.pickle"


def _load_config(mac: str):
    try:
        return pickle.loads(_cache_file(mac).read_bytes())
    except FileNotFoundError:
        return None
    except Exception as exc:
        logger.warning("Ignoring unreadable config cache for %s: %s", mac, exc)
        return None


def _save_config(mac: str, config) -> None:
    if config is None:
        return
    try:
        CONFIG_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _cache_file(mac).write_bytes(pickle.dumps(config))
    except Exception as exc:
        logger.warning("Could not cache config for %s: %s", mac, exc)


# --- BLE -----------------------------------------------------------------------

async def _wait_for_advert(mac: str, timeout: float) -> BLEDevice:
    """Scan in short windows until the device advertises; returns its BLEDevice."""
    found = asyncio.Event()
    hit: dict[str, BLEDevice] = {}

    def on_adv(device: BLEDevice, _adv):
        if device.address.upper() == mac:
            hit["dev"] = device
            found.set()

    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while (left := end - loop.time()) > 0:
        async with BleakScanner(detection_callback=on_adv):
            try:
                await asyncio.wait_for(found.wait(), min(SCAN_WINDOW_S, left))
            except asyncio.TimeoutError:
                pass
        if found.is_set():  # scanner is stopped here, so connect right away
            return hit["dev"]
    raise asyncio.TimeoutError


async def _background_push(mac: str, image_bytes: bytes) -> None:
    try:
        image = Image.open(BytesIO(image_bytes))
        image.load()
    except Exception as exc:
        logger.error("Failed to parse image for %s: %s", mac, exc)
        return

    async with _push_locks.setdefault(mac, asyncio.Lock()):
        loop = asyncio.get_running_loop()
        deadline = loop.time() + PUSH_DEADLINE_S
        attempt = 0

        while (remaining := deadline - loop.time()) > 0:
            attempt += 1
            logger.info("Waiting for %s to wake (%.0fs left)...", mac, remaining)
            try:
                ble_device = await _wait_for_advert(mac, remaining)
            except asyncio.TimeoutError:
                break

            started = loop.time()
            try:
                async with OpenDisplayDevice(
                    mac_address=mac,
                    ble_device=ble_device,
                    config=_load_config(mac),
                    max_attempts=1,  # if this fails the device is asleep again
                ) as device:
                    _save_config(mac, device.config)
                    await device.upload_image(image, fit=FitMode.CONTAIN)
                logger.info("Pushed image to %s (attempt %d, %.1fs after wake)",
                            mac, attempt, loop.time() - started)
                return
            except Exception as exc:
                logger.warning("Attempt %d for %s failed after %.1fs: %s",
                               attempt, mac, loop.time() - started, exc)

        logger.error("Gave up pushing to %s after %d attempt(s)", mac, attempt)


# --- API -----------------------------------------------------------------------

@app.get("/scan")
async def scan(timeout: float = Query(default=30.0, ge=1.0, le=30.0)):
    """Discover nearby OpenDisplay BLE devices."""
    if any(lock.locked() for lock in _push_locks.values()):
        raise HTTPException(status_code=409, detail="A push is in progress; scan later")
    try:
        found = await discover_devices(timeout=timeout)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"BLE scan failed: {exc}") from exc
    return {"devices": [{"name": name, "mac": mac} for name, mac in found.items()]}


@app.post("/push/{mac}", status_code=202)
async def push_image(mac: str, request: Request, background_tasks: BackgroundTasks):
    """Queue an image; it is delivered the next time the device wakes."""
    image_bytes = await request.body()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Empty image body")

    mac = _norm_mac(mac)
    background_tasks.add_task(_background_push, mac, image_bytes)
    return {"status": "accepted", "mac": mac}


def _dev():
    import uvicorn
    uvicorn.run("main:app", reload=True, port=int(os.environ.get("PORT", 8000)))


def _prod():
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))