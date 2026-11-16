using Greenhouse.Alerts.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Greenhouse.Alerts.Controllers
{
    [ApiController]
    [Authorize]
    [Route("glasshouse/v1/zones")]
    public class ZoneReadingsController : ControllerBase
    {
        private readonly IZoneReadingService _readings;

        public ZoneReadingsController(IZoneReadingService readings)
        {
            _readings = readings;
        }

        [HttpGet("{zoneId}/readings")]
        public IActionResult GetReadings(string zoneId)
        {
            return Ok(_readings.ListReadings(zoneId));
        }

        [HttpPost("{zoneId}/alarms/ack")]
        public IActionResult AcknowledgeAlarm(string zoneId)
        {
            _readings.AcknowledgeAlarm(zoneId);
            return NoContent();
        }
    }
}
