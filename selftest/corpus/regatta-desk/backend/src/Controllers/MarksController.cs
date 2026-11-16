using Microsoft.AspNetCore.Mvc;

namespace Regatta.Api.Controllers
{
    [ApiController]
    [Route("marks/v1")]
    public class MarksController : ControllerBase
    {
        [HttpPost("{id}/round")]
        public IActionResult Round(string id)
        {
            return Ok();
        }

        [HttpPost("{id}/skip")]
        public IActionResult Skip(string id)
        {
            return Ok();
        }

        [HttpGet("{id}")]
        public IActionResult Get(string id)
        {
            return Ok();
        }
    }
}
