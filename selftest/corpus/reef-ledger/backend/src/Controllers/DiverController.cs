using Microsoft.AspNetCore.Mvc;

namespace ReefLedger.Api.Controllers
{
    [ApiController]
    [Route("reef/v1")]
    public class DiverController : ControllerBase
    {
        [HttpGet("divers/me")]
        public IActionResult GetCurrentDiver()
        {
            return Ok();
        }

        [HttpGet("divers/{diverId}")]
        public IActionResult GetDiver(string diverId)
        {
            return Ok();
        }

        [HttpGet("divers/{diverId}/logs")]
        public IActionResult GetLogs(string diverId)
        {
            if (string.IsNullOrEmpty(diverId))
            {
                return BadRequest();
            }
            return Ok();
        }
    }
}
