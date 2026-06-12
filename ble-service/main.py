import logging
from io import BytesIO

from fastapi import FastAPI, HTTPException, Query, Request
from opendisplay import OpenDisplayDevice, FitMode, discover_devices
from PIL import Image

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="BLE Display Service")


async def _push_to_device(mac: str, image: Image.Image) -> dict:
    try:
        async with OpenDisplayDevice(mac_address=mac) as device:
            await device.upload_image(image, fit=FitMode.CONTAIN)
        logger.info("Pushed image to %s", mac)
        return {"mac": mac, "success": True}
    except Exception as exc:
        logger.error("Failed to push to %s: %s", mac, exc)
        return {"mac": mac, "success": False, "error": str(exc)}


@app.get("/scan")
async def scan(timeout: float = Query(default=5.0, ge=1.0, le=30.0)):
    """Discover nearby OpenDisplay BLE devices."""
    try:
        found = await discover_devices(timeout=timeout)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"BLE scan failed: {exc}") from exc
    devices = [{"name": name, "mac": mac} for name, mac in found.items()]
    return {"devices": devices}


@app.post("/push/{mac}")
async def push_image(mac: str, request: Request):
    """Push the raw image body to a single BLE display."""
    image_bytes = await request.body()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Empty image body")

    try:
        pil_image = Image.open(BytesIO(image_bytes))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid image data: {exc}") from exc

    return await _push_to_device(mac, pil_image)


def _dev():
    import uvicorn
    uvicorn.run("main:app", reload=True, port=8000)


def _prod():
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000)
