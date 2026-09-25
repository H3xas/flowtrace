using System.Collections.Generic;
using Greenhouse.Alerts.Models;

namespace Greenhouse.Alerts.DataAccess
{
    public interface IReadingRepository
    {
        IReadOnlyList<ZoneReading> ListReadings(string zoneId);
        void MarkAlarmAcknowledged(string zoneId);
    }

    public class ReadingRepository : IReadingRepository
    {
        public IReadOnlyList<ZoneReading> ListReadings(string zoneId)
        {
            return new List<ZoneReading>();
        }

        public void MarkAlarmAcknowledged(string zoneId)
        {
        }
    }
}
