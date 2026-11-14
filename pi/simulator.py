#!/usr/bin/env python3
"""Enviro Sense sensor simulator for Raspberry Pi.
Replace read_sensors() with real sensor code later; nothing else changes.

Demo triggers (run in a second SSH window):
  touch /tmp/fire      fast fire event, about 40 seconds
  touch /tmp/smolder   slow burn, about 4 minutes: the early warning fires first, then the warning limits
"""

import json
import math
import os
import random
import time
import urllib.request
import urllib.error

# ---------- CONFIG ----------
SERVER_URL = "http://192.168.137.1:3000/api/sensor/readings"
DEVICE_KEY = "enviro-pi-key-2026-change-me"   # must match DEVICE_KEY in the laptop .env
DEVICE_ID = "haldia-01"
LOCATION = "Haldia"
INTERVAL = 5                                   # seconds between readings
FIRE_FLAG = "/tmp/fire"                        # touch this file to start a fast fire event
SMOLDER_FLAG = "/tmp/smolder"                  # touch this file to start a slow burn
SMOLDER_SECONDS = 240
RANDOM_FIRE = False                            # True = a fire starts by itself now and then (do not use during a demo)
# ----------------------------

fire_until = 0.0       # time when the current fire event ends
smolder_start = 0.0    # time when the current slow burn started (0 = none)


def cpu_temp():
    """Real CPU temperature of the Pi."""
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return round(int(f.read().strip()) / 1000.0, 1)
    except OSError:
        return 45.0


def read_sensors():
    global fire_until, smolder_start
    now = time.time()
    hour = time.localtime().tm_hour + time.localtime().tm_min / 60

    # Daily rhythm: warmest around 14:00, coolest around 04:00
    base_temp = 29 + 6 * math.sin((hour - 9) / 24 * 2 * math.pi)
    temperature = base_temp + random.uniform(-0.6, 0.6)
    humidity = 72 - (temperature - 23) * 2.2 + random.uniform(-2, 2)
    smoke = 60 + random.uniform(-15, 25)

    # Start a fast fire event: by file flag, or a small random chance
    if os.path.exists(FIRE_FLAG):
        os.remove(FIRE_FLAG)
        fire_until = now + 40
        print(">>> FIRE EVENT started (40 s)")
    elif RANDOM_FIRE and fire_until < now and random.random() < 0.002:
        fire_until = now + 40
        print(">>> Random FIRE EVENT started (40 s)")

    if now < fire_until:
        left = fire_until - now
        intensity = min(1.0, (40 - left) / 12)          # ramps up over ~12 s
        temperature += 22 * intensity + random.uniform(0, 2)
        humidity -= 30 * intensity
        smoke += 700 * intensity + random.uniform(-40, 60)

    # Start a slow burn: temperature, smoke and dryness creep up over 4 minutes
    if os.path.exists(SMOLDER_FLAG):
        os.remove(SMOLDER_FLAG)
        smolder_start = now
        print(">>> SMOLDER started (%d s)" % SMOLDER_SECONDS)

    if smolder_start:
        elapsed = now - smolder_start
        if elapsed < SMOLDER_SECONDS + 20:
            frac = min(1.0, elapsed / SMOLDER_SECONDS)   # 0 -> 1, then holds for 20 s
            temperature += 16 * frac
            humidity -= 22 * frac
            smoke += 330 * frac + random.uniform(-10, 20)
        else:
            smolder_start = 0.0
            print(">>> SMOLDER ended")

    return {
        "device_id": DEVICE_ID,
        "location": LOCATION,
        "temperature": round(temperature, 1),
        "humidity": round(max(5, min(100, humidity)), 1),
        "smoke": round(max(0, smoke), 1),
        "cpu_temp": cpu_temp(),
    }


def send(reading):
    req = urllib.request.Request(
        SERVER_URL,
        data=json.dumps(reading).encode(),
        headers={"Content-Type": "application/json", "x-device-key": DEVICE_KEY},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())


print(f"Enviro Sense simulator -> {SERVER_URL}")
print("Tip: touch /tmp/fire (fast fire) or touch /tmp/smolder (slow burn) in another SSH window.\n")

while True:
    data = read_sensors()
    try:
        result = send(data)
        print(f"{time.strftime('%H:%M:%S')}  T={data['temperature']}C  H={data['humidity']}%  "
              f"smoke={data['smoke']}  cpu={data['cpu_temp']}C  -> {result['status']}")
    except urllib.error.HTTPError as e:
        print("Server rejected the data:", e.code, e.read().decode())
    except Exception as e:
        print("Cannot reach server:", e)
    time.sleep(INTERVAL)
