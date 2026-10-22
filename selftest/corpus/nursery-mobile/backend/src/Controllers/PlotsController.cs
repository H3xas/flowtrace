using Microsoft.AspNetCore.Mvc;

namespace Nursery.Api.Controllers
{
    [ApiController]
    [Route("nursery/v1")]
    public class PlotsController : ControllerBase
    {
        [HttpGet("plots/{plotId}/seedlings")]
        public IActionResult GetSeedlings(string plotId)
        {
            return Ok();
        }

        [HttpPost("plots/{plotId}/water")]
        public IActionResult Water(string plotId)
        {
            return Ok();
        }

        [HttpPut("plots/{plotId}/label")]
        public IActionResult Relabel(string plotId)
        {
            return Ok();
        }

        [HttpGet("plots/{plotId}/summary")]
        public IActionResult GetSummary(string plotId)
        {
            return Ok();
        }

        [HttpGet("plots/{plotId}/forecast")]
        public IActionResult GetForecast(string plotId)
        {
            return Ok();
        }

        [HttpDelete("plots/{plotId}/lock")]
        public IActionResult ReleaseLock(string plotId)
        {
            return NoContent();
        }

        [HttpGet("plots/{plotId}/history")]
        public IActionResult GetHistory(string plotId)
        {
            return Ok();
        }

        [HttpPost("plots/{plotId}/notes")]
        public IActionResult AddNote(string plotId)
        {
            return Ok();
        }

        [HttpPut("plots/{plotId}/watchers")]
        public IActionResult ReplaceWatchers(string plotId)
        {
            return Ok();
        }

        [HttpGet("plots/{plotId}/sensors")]
        public IActionResult GetSensors(string plotId)
        {
            return Ok();
        }

        [HttpPost("plots/{plotId}/health")]
        public IActionResult MarkHealthy(string plotId)
        {
            return Ok();
        }
    }
}
