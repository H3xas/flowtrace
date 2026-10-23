using Greenhouse.Alerts.Models;

namespace Greenhouse.Alerts.DataAccess
{
    public interface IZoneRepository
    {
        Zone FindZone(string zoneId);
    }

    public class ZoneRepository : IZoneRepository
    {
        public Zone FindZone(string zoneId)
        {
            return new Zone { Id = zoneId };
        }
    }
}
