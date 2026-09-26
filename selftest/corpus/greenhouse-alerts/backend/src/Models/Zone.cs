using System.Collections.Generic;

namespace Greenhouse.Alerts.Models
{
    public class Zone
    {
        public string Id { get; set; }
        public bool HasIrrigationSchedule { get; set; }
        public List<string> EditorIds { get; set; } = new List<string>();
        public List<string> ViewerIds { get; set; } = new List<string>();
    }
}
