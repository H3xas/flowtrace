using Microsoft.AspNetCore.Mvc;

namespace Regatta.Api.Controllers
{
    [ApiController]
    [Route("groups/v1")]
    public class GroupsController : ControllerBase
    {
        [HttpGet("{id}")]
        public IActionResult Get(string id)
        {
            return Ok();
        }
    }
}
