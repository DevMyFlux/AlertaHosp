import { RawTelemetryData, ALL_SECTORS } from '../types';
import { addMinutes, formatISO } from 'date-fns';

export function generateMockData(): RawTelemetryData[] {
  const data: RawTelemetryData[] = [];
  let currentTime = new Date();
  currentTime.setHours(0, 0, 0, 0); // Start of day

  // Running totals for each sector
  const cumulativeTotals: Record<string, number> = {};
  ALL_SECTORS.forEach(s => cumulativeTotals[s] = Math.floor(Math.random() * 10000));

  // Generate 24 hours of data at 15m intervals (96 data points)
  for (let i = 0; i <= 96; i++) {
    const row: RawTelemetryData = {
      E3TimeStamp: formatISO(currentTime)
    };

    const hour = currentTime.getHours();

    ALL_SECTORS.forEach(sector => {
      // Simulate base load + time-of-day specific usage
      let usage = Math.random() * 5; // base usage
      
      // Add logic based on string
      if (sector.includes('ONC') && hour >= 8 && hour <= 18) usage += 10;
      if (sector.includes('UTI')) usage += 15; // 24/7 constant high load
      if (sector.includes('RM') || sector.includes('Tomografia')) {
        // Peaks during daytime, sometimes heavy spikes
        if (hour >= 7 && hour <= 20 && Math.random() > 0.5) usage += 50;
      }
      if (sector.includes('CME') && hour >= 18 && hour <= 23) usage += 20; // Material sterilization at night

      // Simulating HVAC usage
      if (sector.includes('CLIM')) {
         if (hour >= 10 && hour <= 16) usage += 25; // Hottest part of the day
         if (hour >= 1 && hour <= 5) usage *= 0.5; // lower hvac at night
      }

      // INJECT ANOMALIES at the end of the simulation (i > 80 is in the last 4 hours)
      if (i > 80) {
        if (sector === 'DJ_AC_UTI_NEO' && i === 85) {
          usage += 120; // Massive spike
        }
        if (sector === 'ME_CLIM_CHILLER_1' && i === 90) {
          usage += 80; // Big spike
        }
        if (sector === 'DJ_RM_1' && i === 92) {
          usage += 150;
        }
      }

      cumulativeTotals[sector] += usage;
      row[sector] = parseFloat(cumulativeTotals[sector].toFixed(2));
      
      // Simulate random quality drops
      row[`${sector}_Quality`] = Math.random() > 0.99 ? 0 : 192; 
    });

    data.push(row);
    currentTime = addMinutes(currentTime, 15);
  }

  return data;
}
