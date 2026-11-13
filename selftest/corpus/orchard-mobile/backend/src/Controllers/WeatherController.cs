using Microsoft.AspNetCore.Mvc;

namespace Orchard.Api.Controllers
{
    [ApiController]
    [Route("orchard/v1")]
    public class WeatherController : ControllerBase
    {
        [HttpGet("weather/current/{plotId}")]
        public IActionResult GetCurrent(string plotId)
        {
            return Ok();
        }

        [HttpGet("weather/current/{plotId}/summary")]
        public IActionResult GetSummary(string plotId)
        {
            return Ok();
        }

        [HttpGet("weather/current/{plotId}/forecast")]
        public IActionResult GetForecast(string plotId)
        {
            return Ok();
        }

        [HttpGet("weather/legacy/{plotId}")]
        public IActionResult GetLegacy(string plotId)
        {
            return Ok();
        }

        [HttpGet("weather/legacy/{plotId}/archive")]
        public IActionResult GetArchive(string plotId)
        {
            return Ok();
        }

        [HttpGet("metrics/{plotId}")]
        public IActionResult GetMetrics(string plotId)
        {
            return Ok();
        }

        [HttpGet("hidden/{plotId}")]
        public IActionResult GetHidden(string plotId)
        {
            return Ok();
        }

        [HttpGet("ledger/{plotId}")]
        public IActionResult GetLedger(string plotId)
        {
            return Ok();
        }

        [HttpGet("cycle/a/{plotId}")]
        public IActionResult GetCycleA(string plotId)
        {
            return Ok();
        }
    }
}
