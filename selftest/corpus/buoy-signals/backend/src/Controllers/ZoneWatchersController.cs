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
        private readonly HarborBridge _relay;

        public ZoneWatchersController(IWatcherService watchers, HarborBridge relay)
        {
            _watchers = watchers;
            _relay = relay;
        }

        [HttpGet("{zoneId}/watchers")]
        public IActionResult GetWatchers(string zoneId)
        {
            // The relay is declared in another service, so the extractor holds no facts for
            // it: the walk can only continue through the code index.
            var relayed = _relay.Forward(zoneId);
            return Ok(new { watchers = _watchers.ListWatchers(zoneId), relayed });
        }

        [HttpPut("{zoneId}/watchers")]
        public IActionResult ReplaceWatchers(string zoneId, [FromBody] ReplaceWatchersRequest request)
        {
            if (request == null || request.GrowerIds == null)
            {
                return BadRequest("growerIds is required");
            }

            var result = _watchers.ReplaceWatchers(zoneId, request.GrowerIds);
            return Ok(result);
        }
    }
}
