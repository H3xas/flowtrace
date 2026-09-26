using System.Collections.Generic;
using Greenhouse.Alerts.DataAccess;
using Greenhouse.Alerts.Models;

namespace Greenhouse.Alerts.Services
{
    public interface IZoneReadingService
    {
        IReadOnlyList<ZoneReading> ListReadings(string zoneId);
        void AcknowledgeAlarm(string zoneId);
    }

    public class ZoneReadingService : IZoneReadingService
    {
        private readonly IReadingRepository _store;

        public ZoneReadingService(IReadingRepository store)
        {
            _store = store;
        }

        public IReadOnlyList<ZoneReading> ListReadings(string zoneId)
        {
            return _store.ListReadings(zoneId);
        }

        public void AcknowledgeAlarm(string zoneId)
        {
            _store.MarkAlarmAcknowledged(zoneId);
        }
    }
}
