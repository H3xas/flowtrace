using Microsoft.AspNetCore.Mvc;

namespace Kite.Api.Controllers
{
    [ApiController]
    [Route("clubs/v1")]
    public class ClubsController : ControllerBase
    {
        [HttpPost("join/{id}")]
        public IActionResult Join(string id)
        {
            return Ok();
        }

        [HttpDelete("{id}")]
        public IActionResult Remove(string id)
        {
            return NoContent();
        }

        [HttpGet("health")]
        public IActionResult Health()
        {
            return Ok();
        }
    }
}
