using System.Collections.Generic;

namespace Greenhouse.Alerts.Caching
{
    public interface IZoneCache
    {
        void Refresh(string zoneId);
    }

    public class ZoneCache : IZoneCache
    {
        public Dictionary<string, long> Versions { get; } = new Dictionary<string, long>();

        public void Refresh(string zoneId)
        {
            Versions[zoneId] = Versions.TryGetValue(zoneId, out var version) ? version + 1 : 1;
        }
    }
}
