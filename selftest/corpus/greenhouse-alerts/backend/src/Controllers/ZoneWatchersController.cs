using Greenhouse.Alerts.Models;
using Greenhouse.Alerts.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Greenhouse.Alerts.Controllers
{
    [ApiController]
    [Authorize]
    [Route("glasshouse/v1/zones")]
    public class ZoneWatchersController : ControllerBase
    {
        private readonly IWatcherService _watchers;

        public ZoneWatchersController(IWatcherService watchers)
        {
            _watchers = watchers;
        }

        [HttpGet("{zoneId}/watchers")]
        public IActionResult GetWatchers(string zoneId)
        {
            return Ok(_watchers.ListWatchers(zoneId));
        }

        [HttpPut("{zoneId}/watchers")]
        public IActionResult ReplaceWatchers(string zoneId, [FromBody] ReplaceWatchersRequest request)
        {
            if (request == null || request.GrowerIds == null)
            {
                return BadRequest("growerIds is required");
            }

            _watchers.ReplaceWatchers(zoneId, request.GrowerIds);
            return NoContent();
        }
    }
}
