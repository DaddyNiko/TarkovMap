# TarkovMap

Live GPS minimap and full map for Escape from Tarkov, drawn from the game's own log files and screenshot names. No memory reading, no injection, no enemy positions.

- Heading-up minimap overlay on the main screen, full map on the second monitor
- Quests on the current map with trader portraits, live from the game's notifications
- Extracts, place names, keys, bosses, scav spawns, hazards, containers as layers
- Squad sharing on LAN: teammates, pings, status flags, in-game name tags
- Screenshots are deleted the moment they are read

Run `TarkovMap.exe`, open Setup, bind the Screenshot key in EFT, done. Full guide inside the app under Help.

Map data and tiles: [tarkov.dev](https://tarkov.dev) (MIT). Default base imagery: the 3D renders by [RE3MR](https://reemr.se) (CC BY-NC-SA 4.0), downloaded once per map, sliced into tiles locally and aligned to game coordinates with the Align tool on the Map page; tarkov.dev's photo tiles with our own drawn buildings are the fallback and a switchable filter.

## Why screenshots and not screen-watching

When you press the game's Screenshot key, Tarkov names the file with your exact position and facing. The app reads the name, deletes the file, moves your dot. The screen itself carries no coordinates (no minimap, no readout), so a vision model could only guess, slowly, at a cost per frame. Nothing reads the game's memory or touches its files.

## Dev

```
npm install
npm test
npm run dev
npm run build     # portable exe -> TarkovMap.exe
```
