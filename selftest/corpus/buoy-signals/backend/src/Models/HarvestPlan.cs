using System.Collections.Generic;

namespace Greenhouse.Alerts.Models
{
    public class HarvestPlan
    {
        public string ZoneId { get; set; }
        public IReadOnlyList<double> Inputs { get; set; }

        public static HarvestPlan Compose(string zoneId, IReadOnlyList<double> inputs)
        {
            return new HarvestPlan { ZoneId = zoneId, Inputs = inputs };
        }
    }
}
