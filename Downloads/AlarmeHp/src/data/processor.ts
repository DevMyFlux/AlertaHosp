import { RawTelemetryData, ProcessedTelemetryData, ALL_SECTORS } from '../types.js';
import { parseISO, format, getHours } from 'date-fns';

function getPeriod(hour: number): 'Madrugada' | 'Manhã' | 'Tarde' | 'Noite' {
  if (hour >= 0 && hour < 6) return 'Madrugada';
  if (hour >= 6 && hour < 12) return 'Manhã';
  if (hour >= 12 && hour < 18) return 'Tarde';
  return 'Noite';
}

function parseNumber(val: any): number {
  if (val == null || val === '') return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  if (typeof val === 'string') {
    // If it has a comma, it might be Brazillian "42.123,45" or "123,45"
    if (val.includes(',')) {
      const cleanStr = val.replace(/\./g, '').replace(',', '.');
      const num = Number(cleanStr);
      return isNaN(num) ? 0 : num;
    }
    // Else regular number string "123.45"
    const num = Number(val);
    return isNaN(num) ? 0 : num;
  }
  return 0;
}

export function processCumulativeData(rawData: RawTelemetryData[]): ProcessedTelemetryData[] {
  if (!rawData || rawData.length === 0) return [];

  const validData = rawData.filter(d => d && d.E3TimeStamp);

  // Sort by time just in case
  const sorted = [...validData].sort((a, b) => {
    const timeA = new Date(a.E3TimeStamp.replace(' ', 'T')).getTime();
    const timeB = new Date(b.E3TimeStamp.replace(' ', 'T')).getTime();
    return timeA - timeB;
  });

  const processed: ProcessedTelemetryData[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const previous = sorted[i - 1];

    // Ensure valid date
    let date;
    try {
      const timestampStr = typeof current.E3TimeStamp === 'string' ? current.E3TimeStamp.replace(' ', 'T') : current.E3TimeStamp;
      date = typeof timestampStr === 'string' ? parseISO(timestampStr) : new Date(timestampStr);
      if (isNaN(date.getTime())) {
        date = new Date(); // fallback
      }
    } catch {
      date = new Date();
    }
    const hour = getHours(date);

    const record: ProcessedTelemetryData = {
      timestamp: String(current.E3TimeStamp),
      time: format(date, 'HH:mm'),
      hour: hour,
      period: getPeriod(hour)
    };

    let totalConsumption = 0;
    let corruptedTags = 0;

    ALL_SECTORS.forEach(sector => {
      const qualityKey = `${sector}_Quality`;
      
      const currentQuality = current[qualityKey] !== undefined ? parseNumber(current[qualityKey]) : 192;
      const previousQuality = previous[qualityKey] !== undefined ? parseNumber(previous[qualityKey]) : 192;
      
      // Values
      const currentVal = parseNumber(current[sector]);
      const previousVal = parseNumber(previous[sector]);

      // Check quality: 192 is good.
      if (currentQuality !== 192 || previousQuality !== 192) {
        // Corrupted or invalid signal
        record[sector] = 0; // Or null/interpolate, but 0 is safe for summation
        corruptedTags++;
      } else {
        // Calculate consumption interval (Current - Previous)
        // If current < previous, it might be a meter reset
        let consumption = currentVal - previousVal;
        if (consumption < 0) {
          consumption = 0; // Better safe than huge spikes
        }

        record[sector] = consumption;
        totalConsumption += consumption;
      }
    });

    record['Total_Consumption'] = totalConsumption;
    record['Data_Integrity'] = 1 - (corruptedTags / ALL_SECTORS.length);

    processed.push(record);
  }

  return processed;
}

export function aggregateByPeriod(processedData: ProcessedTelemetryData[], sectors: string[]) {
  const result: Record<string, any> = { 'Madrugada': {}, 'Manhã': {}, 'Tarde': {}, 'Noite': {} };
  
  processedData.forEach(row => {
    sectors.forEach(sector => {
      result[row.period][sector] = (result[row.period][sector] || 0) + (row[sector] as number);
    });
  });

  return Object.keys(result).map(period => {
    return { name: period, ...result[period] };
  });
}
