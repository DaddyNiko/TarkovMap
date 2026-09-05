# TarkovMap

Live GPS minimap and full map for Escape from Tarkov, drawn from the game's own log files and screenshot names. No memory reading, no injection, no enemy positions.

- Heading-up minimap overlay on the main screen, full map on the second monitor
- Quests on the current map with trader portraits, live from the game's notifications
- Extracts, place names, keys, bosses, scav spawns, hazards, containers as layers
- Squad sharing on LAN: teammates, pings, status flags, in-game name tags
- Screenshots are deleted the moment they are read

Run `TarkovMap.exe`, open Setup, bind the Screenshot key in EFT, done. Full guide inside the app under Help.

Map data and tiles: [tarkov.dev](https://tarkov.dev) (MIT).

## Dev

```
npm install
npm test
npm run dev
npm run build     # portable exe -> TarkovMap.exe
```
