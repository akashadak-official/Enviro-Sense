# Demo script (about 5 minutes)

Use this order when you present Enviro Sense. Start the server first. For the local demo also power the Raspberry Pi and start `python3 ~/simulator.py`.

1. **Intro screen.** The title block sits in the upper middle. Pick **Local** (fixed location, Haldia) or **Global** (search any city).
2. **Login.** Show the password eye, then log in. Watch the title block glide to the top-left corner.
3. **Satellite calendar.** Explain: NASA MODIS and VIIRS hotspots are harmonized into one burning-activity calendar. Click a day, point at the "unusual" markers and the data range.
4. **Global mode (optional).** Search a city such as Ludhiana and show its calendar and 14-day outlook.
5. **14-day outlook.** Bars show the expected level; the backtest line shows how the forecast compared with simple baselines. Read the briefing.
6. **Live sensor.** Tiles show temperature, humidity, smoke and the device status.
7. **Early warning.** Start a slow burn (`touch /tmp/smolder` on the Pi, or the demo button online). The early warning appears first, then the warning.
8. **Automatic alerts.** The red banner appears. Show the email and SMS lines in the terminal (`[DEMO EMAIL]`, `[DEMO SMS]`) and the admin alert history.
9. **My alerts.** Show the home location, mobile verification and the 100 km email / 1 km SMS rule.
10. **History and admin.** Open My history, then the Admin panel: users, sensors, logins, alerts.
11. **Close.** Readings return to normal; an "all clear" is sent after 3 quiet minutes.

If something goes wrong: restart `node server.js`, check the Pi with `ping enviropi`, and keep the screenshots from earlier tests as a backup.
