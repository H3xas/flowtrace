using System;
using System.Linq;
using Greenhouse.Alerts.Models;

namespace Greenhouse.Alerts.Access
{
    public interface IZoneAccess
    {
        void EnsureMayEditZone(string growerId, Zone zone);
    }

    public class ZoneAccess : IZoneAccess
    {
        public void EnsureMayEditZone(string growerId, Zone zone)
        {
            if (zone == null || !zone.EditorIds.Contains(growerId))
            {
                throw new UnauthorizedAccessException("the grower may not edit this zone");
            }
        }
    }
}
