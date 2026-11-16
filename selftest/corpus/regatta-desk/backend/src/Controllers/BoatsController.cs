using Microsoft.AspNetCore.Mvc;

namespace Regatta.Api.Controllers
{
    [ApiController]
    [Route("boats/v1")]
    public class BoatsController : ControllerBase
    {
        [HttpGet("all")]
        public IActionResult List()
        {
            return Ok();
        }

        [HttpPost("{id}/pick")]
        public IActionResult Pick(string id)
        {
            return Ok();
        }

        [HttpDelete("{id}")]
        public IActionResult Remove(string id)
        {
            return Ok();
        }

        [HttpPost("{id}/inspect")]
        public IActionResult Inspect(string id)
        {
            return Ok();
        }
    }
}
